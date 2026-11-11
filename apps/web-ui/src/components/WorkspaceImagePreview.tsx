import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { apiFetch } from "../api";

const MIN_SCALE = 0.02, MAX_SCALE = 32, BUTTON_STEP = 1.25;
// One mouse wheel notch (about 100 units) is about 13%; the easing spreads it over a few frames.
const WHEEL_SPEED = 0.0012, PINCH_SPEED = 0.012;
const EASING = 0.28;
const FIT_PADDING = 16;

type View = { scale: number; x: number; y: number };

export function WorkspaceImagePreview({ agentId, conversationId, path }: { agentId: string; conversationId: string; path: string }) {
	const [src, setSrc] = useState<string | null>(null);
	const [error, setError] = useState(false);
	const [percent, setPercent] = useState<number | null>(null);
	const [dragging, setDragging] = useState(false);
	const stageRef = useRef<HTMLDivElement>(null);
	const imageRef = useRef<HTMLImageElement>(null);
	const size = useRef({ width: 0, height: 0 });
	const view = useRef<View>({ scale: 1, x: 0, y: 0 });
	// Where the eased zoom is heading, and the point of the stage that stays put on the way.
	const target = useRef({ scale: 1, anchorX: 0, anchorY: 0 });
	const frame = useRef<number | null>(null);
	const fitted = useRef(true);
	const drag = useRef<{ x: number; y: number } | null>(null);

	useEffect(() => {
		const controller = new AbortController();
		let objectUrl: string | null = null;
		const query = new URLSearchParams({ conversationId, path });
		void apiFetch(`/api/persistent-agents/${encodeURIComponent(agentId)}/workspace-image?${query}`, { signal: controller.signal })
			.then(async (response) => {
				if (!response.ok) throw new Error("Image unavailable");
				const blob = await response.blob();
				if (controller.signal.aborted) return;
				objectUrl = URL.createObjectURL(blob);
				setSrc(objectUrl);
			})
			.catch(() => { if (!controller.signal.aborted) setError(true); });
		return () => { controller.abort(); if (objectUrl) URL.revokeObjectURL(objectUrl); };
	}, [agentId, conversationId, path]);

	// A picture narrower than the stage stays centred; a larger one cannot leave a gap at its edges.
	function clampAxis(offset: number, content: number, stage: number): number {
		if (content <= stage) return (stage - content) / 2;
		return Math.min(0, Math.max(stage - content, offset));
	}
	function paint(): void {
		const stage = stageRef.current, image = imageRef.current;
		if (!stage || !image) return;
		const current = view.current;
		current.x = clampAxis(current.x, size.current.width * current.scale, stage.clientWidth);
		// Vertically a picture that fits sits at the top, like a document.
		const height = size.current.height * current.scale;
		current.y = height <= stage.clientHeight - FIT_PADDING ? FIT_PADDING : clampAxis(current.y, height, stage.clientHeight);
		image.style.transform = `translate(${current.x}px, ${current.y}px) scale(${current.scale})`;
		// Past 400% the pixels themselves are what someone is looking at.
		image.style.imageRendering = current.scale > 4 ? "pixelated" : "auto";
		setPercent(Math.round(current.scale * 100));
	}
	function zoomViewAt(anchorX: number, anchorY: number, scale: number): void {
		const current = view.current, ratio = scale / current.scale;
		view.current = { scale, x: anchorX - (anchorX - current.x) * ratio, y: anchorY - (anchorY - current.y) * ratio };
	}
	function step(): void {
		frame.current = null;
		const { scale, anchorX, anchorY } = target.current;
		const remaining = Math.log(scale / view.current.scale);
		const reduced = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
		const done = reduced || Math.abs(remaining) < 0.001;
		zoomViewAt(anchorX, anchorY, done ? scale : view.current.scale * Math.exp(remaining * EASING));
		paint();
		if (!done) frame.current = requestAnimationFrame(step);
	}
	function zoomTo(scale: number, anchorX: number, anchorY: number): void {
		fitted.current = false;
		target.current = { scale: Math.min(MAX_SCALE, Math.max(MIN_SCALE, scale)), anchorX, anchorY };
		if (frame.current === null) frame.current = requestAnimationFrame(step);
	}
	function stageCentre(): [number, number] {
		const stage = stageRef.current;
		return [(stage?.clientWidth ?? 0) / 2, (stage?.clientHeight ?? 0) / 2];
	}
	function fit(): void {
		const stage = stageRef.current;
		if (!stage || !size.current.width || !stage.clientWidth || !stage.clientHeight) return;
		fitted.current = true;
		if (frame.current !== null) { cancelAnimationFrame(frame.current); frame.current = null; }
		// Fit shrinks a large picture; a small one stays at its own size.
		const scale = Math.min(1, (stage.clientWidth - FIT_PADDING * 2) / size.current.width, (stage.clientHeight - FIT_PADDING * 2) / size.current.height);
		view.current = { scale, x: 0, y: 0 };
		target.current = { scale, anchorX: 0, anchorY: 0 };
		paint();
	}
	// The handlers read fresh refs, so the listeners below only need attaching once.
	const handlers = useRef({ fit, zoomTo });
	handlers.current = { fit, zoomTo };

	useEffect(() => {
		const stage = stageRef.current;
		if (!stage) return;
		// React's wheel listener is passive, and the page behind must not scroll or zoom.
		const onWheel = (event: WheelEvent) => {
			if (!size.current.width) return;
			event.preventDefault();
			const box = stage.getBoundingClientRect();
			const delta = event.deltaY * (event.deltaMode === 1 ? 33 : event.deltaMode === 2 ? 100 : 1);
			const speed = event.ctrlKey ? PINCH_SPEED : WHEEL_SPEED;
			handlers.current.zoomTo(target.current.scale * Math.exp(-delta * speed), event.clientX - box.left, event.clientY - box.top);
		};
		stage.addEventListener("wheel", onWheel, { passive: false });
		// A tab that was hidden has no size until it is shown; the pane can also be resized.
		const observer = new ResizeObserver(() => {
			if (fitted.current) handlers.current.fit();
			else paint();
		});
		observer.observe(stage);
		return () => {
			stage.removeEventListener("wheel", onWheel);
			observer.disconnect();
			if (frame.current !== null) cancelAnimationFrame(frame.current);
		};
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, []);

	function onImageLoad(): void {
		const image = imageRef.current;
		if (!image) return;
		// An SVG without its own size reports none.
		size.current = { width: image.naturalWidth || 1000, height: image.naturalHeight || 1000 };
		image.style.width = `${size.current.width}px`;
		image.style.height = `${size.current.height}px`;
		fit();
	}
	function onPointerDown(event: ReactPointerEvent<HTMLDivElement>): void {
		if (event.button !== 0 || !size.current.width) return;
		event.currentTarget.setPointerCapture(event.pointerId);
		drag.current = { x: event.clientX, y: event.clientY };
		setDragging(true);
	}
	function onPointerMove(event: ReactPointerEvent<HTMLDivElement>): void {
		if (!drag.current) return;
		// Moving takes over from any zoom still easing.
		if (frame.current !== null) { cancelAnimationFrame(frame.current); frame.current = null; target.current.scale = view.current.scale; }
		view.current.x += event.clientX - drag.current.x;
		view.current.y += event.clientY - drag.current.y;
		drag.current = { x: event.clientX, y: event.clientY };
		paint();
	}
	function endDrag(): void {
		drag.current = null;
		setDragging(false);
	}
	function onDoubleClick(event: React.MouseEvent<HTMLDivElement>): void {
		if (!fitted.current) { fit(); return; }
		const box = event.currentTarget.getBoundingClientRect();
		zoomTo(view.current.scale < 0.99 ? 1 : 2, event.clientX - box.left, event.clientY - box.top);
	}

	return <div className="workspace-preview-image-frame">
		{src && <div className="workspace-preview-image-tools" role="toolbar" aria-label="Picture zoom">
			<button type="button" aria-label="Zoom out" onClick={() => zoomTo(target.current.scale / BUTTON_STEP, ...stageCentre())}>−</button>
			<span aria-live="polite">{percent === null ? "" : `${percent}%`}</span>
			<button type="button" aria-label="Zoom in" onClick={() => zoomTo(target.current.scale * BUTTON_STEP, ...stageCentre())}>+</button>
			<button type="button" onClick={() => zoomTo(1, ...stageCentre())}>100%</button>
			<button type="button" onClick={() => fit()}>Fit</button>
		</div>}
		<div className="workspace-preview-image" ref={stageRef} data-dragging={dragging || undefined} onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={endDrag} onPointerCancel={endDrag} onDoubleClick={onDoubleClick}>
			{src ? <img ref={imageRef} src={src} alt={path.split("/").pop() ?? path} draggable={false} onLoad={onImageLoad} /> : error ? <p>This file could not be previewed.</p> : <p>Loading preview…</p>}
		</div>
	</div>;
}
