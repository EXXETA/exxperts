import { useEffect, useRef, useState, type CSSProperties } from "react";
import { GaugeIcon } from "./icons";

// The popover sizes itself from the ticks it has to hold: six rungs is an
// ordinary case for a model that reaches "max", and the labels are the
// provider's own words, so neither the count nor the widths can be assumed.
// Mono at this size runs about 6.3px per character.
const TICK_CHAR_PX = 6.3;
const TICK_GAP_PX = 12;
const MIN_TICK_SLOT_PX = 46;
const POPOVER_PADDING_PX = 14;
const MIN_POPOVER_PX = 272;

function labelWidthPx(label: string): number {
	return label.length * TICK_CHAR_PX;
}

function popoverMetrics(ladder: Array<{ label: string }>): { width: number; inset: number } {
	const widest = ladder.reduce((max, rung) => Math.max(max, labelWidthPx(rung.label)), 0);
	const slot = Math.max(MIN_TICK_SLOT_PX, widest + TICK_GAP_PX);
	const scaleWidth = slot * Math.max(1, ladder.length - 1);
	// The first and last labels are centred on the ends of the track, so half of
	// each hangs outside it and the inset has to cover that.
	const inset = Math.round(widest / 2 + 8);
	return {
		width: Math.max(MIN_POPOVER_PX, Math.round(scaleWidth + 2 * inset + 2 * POPOVER_PADDING_PX)),
		inset,
	};
}

/**
 * The composer's reasoning-effort control.
 *
 * A pill showing the room's current level; clicking opens a slider whose ticks
 * are the model's OWN dial as the server derived it: one rung per distinct
 * effort the model can produce, each labelled the way its provider names it.
 * Two internal levels that come out as the same effort are one rung, so no two
 * ticks ever behave alike, and "off" appears only where a model can genuinely
 * stop reasoning. The choice is sticky per room, which is why there is no
 * per-message reset.
 *
 * A drag commits once, on release: every tick crossed on the way would
 * otherwise be a frame on the wire and a file write on the server.
 */
export function EffortControl({ level, ladder, disabled, onSelect }: { level: string; ladder: Array<{ level: string; label: string }>; disabled?: boolean; onSelect: (level: string) => void }) {
	const [open, setOpen] = useState(false);
	// Where the thumb sits while a drag is in progress. Null means the level
	// prop is the truth, which it is at every moment except mid-drag.
	const [draggingLevel, setDraggingLevel] = useState<string | null>(null);
	const rootRef = useRef<HTMLDivElement | null>(null);
	const pillRef = useRef<HTMLButtonElement | null>(null);
	const scaleRef = useRef<HTMLDivElement | null>(null);
	const ticksRef = useRef<HTMLDivElement | null>(null);
	const draggingLevelRef = useRef<string | null>(null);

	useEffect(() => {
		if (!open) return;
		function onPointerDown(event: PointerEvent) {
			if (rootRef.current && !rootRef.current.contains(event.target as Node)) setOpen(false);
		}
		function onKeyDown(event: KeyboardEvent) {
			if (event.key === "Escape") setOpen(false);
		}
		document.addEventListener("pointerdown", onPointerDown);
		document.addEventListener("keydown", onKeyDown);
		return () => {
			document.removeEventListener("pointerdown", onPointerDown);
			document.removeEventListener("keydown", onKeyDown);
		};
	}, [open]);

	// A control that stops being usable must not stay open over the composer.
	useEffect(() => { if (disabled) setOpen(false); }, [disabled]);

	// Roving focus: the active tick is the only tabbable one, so after an arrow
	// key moves the selection the focus has to follow it. Only when focus is
	// already inside the group, so a server echo never steals it.
	useEffect(() => {
		if (!open) return;
		const active = document.activeElement;
		if (!(active instanceof HTMLElement) || !ticksRef.current?.contains(active) || active.classList.contains("is-active")) return;
		ticksRef.current.querySelector<HTMLButtonElement>(".effort-tick.is-active")?.focus();
	});

	// Opening hands focus to the choices; closing gives it back to the pill, so
	// keyboard use never lands somewhere it cannot see.
	useEffect(() => {
		if (open) ticksRef.current?.querySelector<HTMLButtonElement>(".effort-tick.is-active")?.focus();
		else if (document.activeElement instanceof HTMLElement && rootRef.current?.contains(document.activeElement)) pillRef.current?.focus();
	}, [open]);

	const shownLevel = draggingLevel ?? level;
	const activeIndex = Math.max(0, ladder.findIndex((rung) => rung.level === shownLevel));
	const lastIndex = Math.max(1, ladder.length - 1);
	const positionPercent = (index: number) => (ladder.length <= 1 ? 50 : (index / lastIndex) * 100);
	// What the user reads is the provider's name for the effort; what travels
	// on the wire is always the internal token.
	const shownLabel = ladder.find((rung) => rung.level === level)?.label ?? level;
	const metrics = popoverMetrics(ladder);

	function commitIndex(index: number): void {
		const next = ladder[Math.min(ladder.length - 1, Math.max(0, index))]?.level;
		if (next && next !== level) onSelect(next);
	}

	function endDrag(): void {
		const pending = draggingLevelRef.current;
		draggingLevelRef.current = null;
		setDraggingLevel(null);
		if (pending && pending !== level) onSelect(pending);
	}

	// A click or drag anywhere on the track snaps to the nearest tick: the
	// levels are named steps, so there is nothing between them to land on.
	function levelFromPointer(clientX: number): string | null {
		const box = scaleRef.current?.getBoundingClientRect();
		if (!box || box.width <= 0 || ladder.length <= 1) return null;
		const ratio = Math.min(1, Math.max(0, (clientX - box.left) / box.width));
		return ladder[Math.round(ratio * lastIndex)]?.level ?? null;
	}

	return (
		<div className="effort-control" ref={rootRef}>
			<button
				ref={pillRef}
				className="icon-btn effort-pill"
				title="How hard this room thinks. Takes effect from your next message and stays until you change it"
				aria-label={`Reasoning effort: ${shownLabel}`}
				aria-haspopup="dialog"
				aria-expanded={open}
				disabled={disabled}
				onClick={() => setOpen((value) => !value)}
			><GaugeIcon /><span className="effort-pill-level">{shownLabel}</span></button>
			{open && (
				<div className="effort-popover" role="dialog" aria-label="Reasoning effort" style={{ width: `${metrics.width}px`, ["--effort-inset" as string]: `${metrics.inset}px` } as CSSProperties}>
					<div className="effort-ends" aria-hidden="true">
						<span>Faster</span>
						<span>Smarter</span>
					</div>
					{/* Decorative twin of the tick row below: the ticks are the real
					    controls, so this layer carries no role of its own. */}
					<div
						className="effort-scale"
						ref={scaleRef}
						aria-hidden="true"
						onPointerDown={(event) => {
							event.currentTarget.setPointerCapture(event.pointerId);
							const next = levelFromPointer(event.clientX);
							draggingLevelRef.current = next ?? level;
							setDraggingLevel(next ?? level);
						}}
						onPointerMove={(event) => {
							if (!draggingLevelRef.current) return;
							const next = levelFromPointer(event.clientX);
							if (next && next !== draggingLevelRef.current) {
								draggingLevelRef.current = next;
								setDraggingLevel(next);
							}
						}}
						onPointerUp={(event) => {
							try { event.currentTarget.releasePointerCapture(event.pointerId); } catch {}
							endDrag();
						}}
						// A gesture the browser takes away (a touch turning into a
						// scroll, a window losing the pointer) must end the drag too,
						// or the next hover would silently keep changing the level.
						onPointerCancel={() => endDrag()}
						onLostPointerCapture={() => endDrag()}
					>
						<div className="effort-line" />
						<div className="effort-marker" style={{ left: `${positionPercent(activeIndex)}%` }} />
					</div>
					<div
						className="effort-ticks"
						ref={ticksRef}
						role="radiogroup"
						aria-label="Reasoning effort"
						onKeyDown={(event) => {
							if (event.key === "ArrowLeft" || event.key === "ArrowUp") { event.preventDefault(); commitIndex(activeIndex - 1); }
							else if (event.key === "ArrowRight" || event.key === "ArrowDown") { event.preventDefault(); commitIndex(activeIndex + 1); }
							else if (event.key === "Home") { event.preventDefault(); commitIndex(0); }
							else if (event.key === "End") { event.preventDefault(); commitIndex(ladder.length - 1); }
						}}
					>
						{ladder.map((rung, index) => (
							<button
								key={rung.level}
								type="button"
								role="radio"
								className={`effort-tick${rung.level === shownLevel ? " is-active" : ""}`}
								style={{ left: `${positionPercent(index)}%` }}
								aria-checked={rung.level === shownLevel}
								tabIndex={rung.level === shownLevel ? 0 : -1}
								onClick={() => commitIndex(index)}
							>{rung.label}</button>
						))}
					</div>
				</div>
			)}
		</div>
	);
}
