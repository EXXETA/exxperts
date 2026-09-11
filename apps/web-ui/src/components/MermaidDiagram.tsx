import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { CopyButton } from "./CopyButton";
import { ZOOM_MAX, ZOOM_MIN, fitZoom, parseNaturalSize, scrollToKeepPoint, stepZoom, wheelZoom, type Size } from "../diagram-zoom";

const MAX_MERMAID_CHARS = 12_000;

type MermaidStatus =
	| { state: "loading" }
	| { state: "ready"; svg: string; renderedSource: string; repaired: boolean }
	| { state: "error"; message: string; detail?: string };

// mermaid is heavy; load it lazily on first use so it lands in its own chunk
// and never touches the main bundle. Memoized at module scope so a chat with
// many diagrams shares one initialized instance.
let mermaidLoad: Promise<typeof import("mermaid").default> | null = null;
let renderSeq = 0;

function loadMermaid() {
	if (!mermaidLoad) {
		mermaidLoad = import("mermaid").then((mod) => {
			const mermaid = mod.default;
			mermaid.initialize({
				startOnLoad: false,
				securityLevel: "strict",
				theme: "base",
				deterministicIds: true,
				maxTextSize: MAX_MERMAID_CHARS,
				fontFamily: "Sen, Arial, Helvetica, sans-serif",
				themeVariables: {
					background: "transparent",
					primaryColor: "#ffffff",
					primaryTextColor: "#111111",
					primaryBorderColor: "#111111",
					lineColor: "#111111",
					secondaryColor: "#f4f4f2",
					tertiaryColor: "#fbfbfa",
					textColor: "#111111",
					fontFamily: "Sen, Arial, Helvetica, sans-serif",
				},
			});
			return mermaid;
		});
	}
	return mermaidLoad;
}

async function renderMermaidSvg(renderIdPrefix: string, source: string): Promise<string> {
	const mermaid = await loadMermaid();
	const renderId = `${renderIdPrefix}-${++renderSeq}`;
	const { svg } = await mermaid.render(renderId, source);
	return svg;
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

async function renderMermaidWithRepair(renderIdPrefix: string, source: string): Promise<{ svg: string; renderedSource: string; repaired: boolean }> {
	try {
		return { svg: await renderMermaidSvg(renderIdPrefix, source), renderedSource: source, repaired: false };
	} catch (error) {
		const repairedSource = repairFlowchartLabels(source);
		if (repairedSource === source) throw error;
		try {
			return { svg: await renderMermaidSvg(`${renderIdPrefix}-repaired`, repairedSource), renderedSource: repairedSource, repaired: true };
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

export function MermaidDiagram({ chart }: { chart: string }) {
	const reactId = useId();
	const source = useMemo(() => chart.trim(), [chart]);
	const baseId = useMemo(() => `mermaid-${reactId.replace(/[^A-Za-z0-9_-]/g, "")}`, [reactId]);
	const [status, setStatus] = useState<MermaidStatus>({ state: "loading" });
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
			setStatus({ state: "loading" });
			try {
				const result = await renderMermaidWithRepair(baseId, source);
				if (!cancelled) setStatus({ state: "ready", ...result });
			} catch (error) {
				if (!cancelled) setStatus({ state: "error", message: "The assistant generated invalid Mermaid syntax.", detail: errorMessage(error) });
			}
		}
		void render();
		return () => {
			cancelled = true;
		};
	}, [baseId, source]);

	// The in-chat canvas learns the drawing's real width so "enlarged" can mean
	// real pixels for a wide diagram, not just "fill the column".
	useLayoutEffect(() => {
		if (status.state !== "ready") return;
		setNaturalWidth(measureSvg(canvasRef.current)?.width ?? null);
	}, [status]);

	useEffect(() => {
		if (!viewerOpen || status.state !== "ready") return;
		let cancelled = false;
		const renderedSource = status.renderedSource;
		const repaired = status.repaired;
		setViewerStatus({ state: "loading" });
		async function renderViewer() {
			try {
				const svg = await renderMermaidSvg(`${baseId}-viewer`, renderedSource);
				if (!cancelled) setViewerStatus({ state: "ready", svg, renderedSource, repaired });
			} catch (error) {
				if (!cancelled) setViewerStatus({ state: "error", message: "Could not render the expanded diagram.", detail: errorMessage(error) });
			}
		}
		void renderViewer();
		return () => {
			cancelled = true;
		};
	}, [baseId, source, status.state, viewerOpen]);

	const fitViewer = useCallback((natural: Size | null) => {
		const body = viewerBodyRef.current;
		if (!natural || !body) return;
		const box = contentBox(body);
		setViewerZoom(fitZoom(natural, { width: box.width, height: box.height }));
	}, []);

	// Measure the viewer's own svg the moment it mounts and open at fit: the
	// largest zoom that shows the whole drawing on both axes. Until then the
	// stage is as wide as the body (the pre-measure fallback in CSS), so the
	// first paint already lands close to where fit puts it.
	useLayoutEffect(() => {
		if (viewerStatus.state !== "ready") return;
		const natural = measureSvg(viewerStageRef.current);
		setViewerNatural(natural);
		fitViewer(natural);
	}, [fitViewer, viewerStatus]);

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
			<figure className="mermaid-diagram" aria-label="Rendered Mermaid diagram">
				<div className="mermaid-diagram-frame">
					{/* The canvas toggles the diagram in place: a narrow drawing grows
					    to the column, a wide one goes to its real pixels and scrolls.
					    The expand control beside it is the only way into the viewer;
					    as a sibling over the canvas, its click never reaches the toggle. */}
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
					<button
						type="button"
						className="mermaid-diagram-expand"
						onClick={openViewer}
						aria-label="Open expanded diagram"
						title="Open expanded diagram"
					>
						⤢
					</button>
				</div>
				{status.repaired && <div className="mermaid-diagram-repaired">Mermaid syntax was auto-corrected for display.</div>}
				<details className="mermaid-diagram-source">
					<summary>Mermaid source</summary>
					{/* The source reads as a code block: the same strip, label and
					    copy control a fenced block carries, so the diagram's text
					    can be taken the way any code can. */}
					<div className="code-block">
						<div className="code-block-tools">
							<span className="code-block-lang">mermaid</span>
							<CopyButton text={status.renderedSource} className="code-block-copy" what="code" />
						</div>
						<pre><code>{status.renderedSource}</code></pre>
					</div>
				</details>
				{viewerOpen && (
					<div className="mermaid-viewer-overlay" role="dialog" aria-modal="true" aria-label="Expanded Mermaid diagram" onClick={() => setViewerOpen(false)}>
						<div className="mermaid-viewer-modal" onClick={(event) => event.stopPropagation()}>
							<div className="mermaid-viewer-head">
								<h2>Diagram</h2>
								<div className="mermaid-viewer-actions">
									<button className="icon-btn" type="button" onClick={() => setViewerZoom((value) => stepZoom(value, -1))} disabled={viewerZoom <= ZOOM_MIN} aria-label="Zoom out" title="Zoom out (−)">−</button>
									<button className="icon-btn mermaid-viewer-zoom-value" type="button" onClick={() => setViewerZoom(1)} aria-label="Actual size" title="Actual size (0)">{zoomPercent}%</button>
									<button className="icon-btn" type="button" onClick={() => setViewerZoom((value) => stepZoom(value, 1))} disabled={viewerZoom >= ZOOM_MAX} aria-label="Zoom in" title="Zoom in (+)">+</button>
									<button className="icon-btn" type="button" onClick={() => fitViewer(viewerNatural)} disabled={!viewerNatural} aria-label="Fit to window" title="Fit to window (f)">Fit</button>
									<button className="icon-btn" type="button" onClick={() => setViewerOpen(false)} aria-label="Close" title="Close (Esc)">✕</button>
								</div>
							</div>
							<div className="mermaid-viewer-body" ref={viewerBodyRef}>
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
		<figure className="mermaid-diagram mermaid-diagram-loading" aria-label="Rendering Mermaid diagram">
			<div className="mermaid-diagram-loading-text">Rendering diagram...</div>
		</figure>
	);
}
