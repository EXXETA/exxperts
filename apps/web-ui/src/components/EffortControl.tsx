import { useId, useRef, useState, type CSSProperties, type Ref } from "react";

type EffortRung = { level: string; label: string };

// The providers name their efforts in their own tokens ("xhigh", Google's
// capitals): a person reads one word per effort, whoever made the model.
const EFFORT_DISPLAY_NAMES: Record<string, string> = {
	off: "Off",
	none: "Off",
	minimal: "Minimal",
	low: "Low",
	medium: "Medium",
	high: "High",
	xhigh: "Extra high",
	max: "Max",
};

/** The word a person reads for a provider's effort label; a word the table does not know in title case. */
export function effortDisplayName(label: string): string {
	const lower = label.trim().toLowerCase();
	// Own keys only: a provider's word is data, and "__proto__" or "constructor" must not reach Object's.
	return (Object.hasOwn(EFFORT_DISPLAY_NAMES, lower) ? EFFORT_DISPLAY_NAMES[lower] : undefined) ?? lower.split(/[\s_-]+/).filter(Boolean).map((word) => word.charAt(0).toUpperCase() + word.slice(1)).join(" ");
}

/**
 * A speedometer whose needle stands on the rung in use: one position per rung
 * the model offers, spread over the dial. Only drawn for two rungs or more.
 */
export function SpeedometerIcon({ index, count, size = 14 }: { index: number; count: number; size?: number }) {
	// The dial's arc runs from -135° to 135° from straight up; the needle stays
	// a little inside its ends so the first and last rung read as on the dial.
	const span = 115;
	const angle = count <= 1 ? 0 : -span + (2 * span * Math.min(count - 1, Math.max(0, index))) / (count - 1);
	const radians = (angle * Math.PI) / 180;
	const tipX = 8 + 4.4 * Math.sin(radians);
	const tipY = 8.5 - 4.4 * Math.cos(radians);
	return (
		<svg className="ui-icon speedometer-icon" width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.4} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
			<path d="M3.4 13.1a6.5 6.5 0 1 1 9.2 0" />
			<path className="speedometer-needle" d={`M8 8.5L${tipX.toFixed(2)} ${tipY.toFixed(2)}`} />
			<circle className="speedometer-hub" cx="8" cy="8.5" r="0.9" fill="currentColor" stroke="none" />
		</svg>
	);
}

// The dial's drawing box. Its arc spans the closed control's speedometer's
// angles, so the panel reads as that icon made large; the CSS sizes the box
// and the pointer maths scales from it.
// `endSlack` is how far past an end of the arc a press still picks that end.
const DIAL = { width: 240, height: 150, cx: 120, cy: 100, r: 58, labelR: 92, span: 115, endSlack: 12 };
/** The angle of a share of the arc, 0 at its start and 1 at its end. */
function dialAngle(share: number): number {
	return -DIAL.span + 2 * DIAL.span * share;
}
function dialPoint(angle: number, r: number): [number, number] {
	const radians = (angle * Math.PI) / 180;
	return [DIAL.cx + r * Math.sin(radians), DIAL.cy - r * Math.cos(radians)];
}
function dialArc(from: number, to: number): string {
	const [x0, y0] = dialPoint(from, DIAL.r);
	const [x1, y1] = dialPoint(to, DIAL.r);
	return `M${x0.toFixed(2)} ${y0.toFixed(2)}A${DIAL.r} ${DIAL.r} 0 ${to - from > 180 ? 1 : 0} 1 ${x1.toFixed(2)} ${y1.toFixed(2)}`;
}

// SVG has no gradient along a curve, so the arc's ramp is short pieces, each a
// shade further on: the same colours sit at the same place on any ladder.
const RAMP_STEPS = 96;
const RAMP_PIECES = Array.from({ length: RAMP_STEPS }, (_, piece) => ({
	d: dialArc(dialAngle(piece / RAMP_STEPS), dialAngle((piece + 1) / RAMP_STEPS)),
	share: (piece + 0.5) / RAMP_STEPS,
}));

/**
 * How the needle and knob reach a rung: a swing; on the pointer through a drag;
 * a settle at the drag's end, since they are already there. A drag keeps the way
 * it last went, for its settle to carry on that way.
 */
type DialMotion = "swing" | "follow-up" | "follow-down" | "settle-up" | "settle-down";

/**
 * The effort slider of the model panel, drawn as a dial: the closed control's
 * speedometer opened up, an arc over the rungs of the model's own ladder,
 * filled up to a knob on the one in use, each rung named around it and a
 * needle from the hub. The whole dial is one press area that snaps to the
 * rung nearest the pointer's angle. Drag, click or the arrow keys (Home and
 * End too) move it; a drag commits once, on release, since every stop
 * crossed would otherwise be a frame on the wire and a write on the server.
 * While the knob moves, `onPreview` lets the panel's title follow. The arc's
 * fill deepens towards the top, and the moves spring (see 16-composer.css).
 */
export function EffortSlider({ level, ladder, disabled = false, onSelect, onPreview, sliderRef }: { level: string; ladder: EffortRung[]; disabled?: boolean; onSelect: (level: string) => void; onPreview?: (level: string | null) => void; sliderRef?: Ref<HTMLDivElement> }) {
	// Where the thumb sits mid-drag; null means the level prop is the truth.
	const [draggingLevel, setDraggingLevel] = useState<string | null>(null);
	const draggingLevelRef = useRef<string | null>(null);
	const trackRef = useRef<HTMLDivElement | null>(null);
	const [motion, setMotion] = useState<DialMotion>("swing");
	const reachId = useId();

	const shownLevel = draggingLevel ?? level;
	const activeIndex = Math.max(0, ladder.findIndex((rung) => rung.level === shownLevel));
	const lastIndex = Math.max(1, ladder.length - 1);
	const angleOf = (index: number) => dialAngle(index / lastIndex);

	function setDragging(next: string | null): void {
		draggingLevelRef.current = next;
		setDraggingLevel(next);
		onPreview?.(next);
	}

	function commitIndex(index: number): void {
		const next = ladder[Math.min(ladder.length - 1, Math.max(0, index))]?.level;
		if (next && next !== level) onSelect(next);
	}

	function endDrag(): void {
		const pending = draggingLevelRef.current;
		if (pending === null) return;
		setDragging(null);
		setMotion((now) => (now === "follow-up" ? "settle-up" : now === "follow-down" ? "settle-down" : "swing"));
		// A press is a pick even on the rung shown: that rung may stand for another stored level.
		onSelect(pending);
	}

	// The levels are named steps: a press on the dial takes its angle from the
	// hub, held to the arc's ends, and snaps to the nearest rung. The gap under
	// the hub, past the arc's ends, picks nothing: the level's name sits there,
	// and a press on it would otherwise jump to Low or Max by which half it hit.
	function levelFromPointer(clientX: number, clientY: number): string | null {
		const box = trackRef.current?.getBoundingClientRect();
		if (!box || box.width <= 0 || box.height <= 0) return null;
		const cx = box.left + (box.width * DIAL.cx) / DIAL.width;
		const cy = box.top + (box.height * DIAL.cy) / DIAL.height;
		const angle = (Math.atan2(clientX - cx, cy - clientY) * 180) / Math.PI;
		if (Math.abs(angle) > DIAL.span + DIAL.endSlack) return null;
		const ratio = (Math.min(DIAL.span, Math.max(-DIAL.span, angle)) + DIAL.span) / (2 * DIAL.span);
		return ladder[Math.round(ratio * lastIndex)]?.level ?? null;
	}

	const valueText = effortDisplayName(ladder[activeIndex]?.label ?? shownLevel);
	return (
		<div
			ref={sliderRef}
			className={`effort-slider${disabled ? " is-disabled" : ""}`}
			role="slider"
			tabIndex={disabled ? -1 : 0}
			aria-label="Effort"
			aria-valuemin={1}
			aria-valuemax={ladder.length}
			aria-valuenow={activeIndex + 1}
			aria-valuetext={valueText}
			aria-disabled={disabled || undefined}
			onKeyDown={(event) => {
				if (disabled) return;
				if (event.key === "ArrowLeft" || event.key === "ArrowDown") { event.preventDefault(); commitIndex(activeIndex - 1); }
				else if (event.key === "ArrowRight" || event.key === "ArrowUp") { event.preventDefault(); commitIndex(activeIndex + 1); }
				else if (event.key === "Home") { event.preventDefault(); commitIndex(0); }
				else if (event.key === "End") { event.preventDefault(); commitIndex(ladder.length - 1); }
			}}
			onPointerDown={(event) => {
				if (disabled) return;
				// A press that picks nothing is not a pick: no drag, nothing sent.
				const pressed = levelFromPointer(event.clientX, event.clientY);
				if (pressed === null) return;
				event.currentTarget.setPointerCapture(event.pointerId);
				setMotion("swing");
				setDragging(pressed);
			}}
			onPointerMove={(event) => {
				if (draggingLevelRef.current === null) return;
				const next = levelFromPointer(event.clientX, event.clientY);
				if (next && next !== draggingLevelRef.current) {
					const rungOf = (wanted: string) => ladder.findIndex((rung) => rung.level === wanted);
					setMotion(rungOf(next) > rungOf(draggingLevelRef.current) ? "follow-up" : "follow-down");
					setDragging(next);
				}
			}}
			onPointerUp={(event) => {
				try { event.currentTarget.releasePointerCapture(event.pointerId); } catch {}
				endDrag();
			}}
			// A gesture the browser takes away (a touch turning into a scroll)
			// ends the drag too, or the next hover would keep moving the level.
			onPointerCancel={() => endDrag()}
			onLostPointerCapture={() => endDrag()}
		>
			<div
				className={`effort-dial is-${motion}`}
				ref={trackRef}
				style={{ "--effort-at": activeIndex / lastIndex, "--effort-span": `${DIAL.span}deg` } as CSSProperties}
				onAnimationEnd={() => setMotion("swing")}
			>
				<svg viewBox={`0 0 ${DIAL.width} ${DIAL.height}`} aria-hidden="true" focusable="false">
					<path className="effort-dial-track" d={dialArc(-DIAL.span, DIAL.span)} />
					<mask id={reachId} maskUnits="userSpaceOnUse" x={0} y={0} width={DIAL.width} height={DIAL.height}>
						<path className="effort-dial-reach" pathLength={100} d={dialArc(-DIAL.span, DIAL.span)} />
					</mask>
					<g mask={`url(#${reachId})`}>
						{RAMP_PIECES.map((piece) => <path key={piece.share} className="effort-dial-fill" style={{ "--effort-at": piece.share } as CSSProperties} d={piece.d} />)}
					</g>
					{ladder.map((rung, index) => {
						const [x, y] = dialPoint(angleOf(index), DIAL.r);
						return <circle key={rung.level} className={`effort-dial-tick${index <= activeIndex ? " is-on" : ""}`} cx={x.toFixed(2)} cy={y.toFixed(2)} r={1.8} />;
					})}
					{/* Drawn pointing straight up from the hub: the CSS turns them with the level. */}
					<g transform={`translate(${DIAL.cx} ${DIAL.cy})`}>
						<g className="effort-dial-hand">
							<line className="effort-dial-needle" x1={0} y1={0} x2={0} y2={16 - DIAL.r} />
							<circle className="effort-slider-thumb" cx={0} cy={-DIAL.r} r={7} />
						</g>
					</g>
					<circle className="effort-dial-hub" cx={DIAL.cx} cy={DIAL.cy} r={3.5} />
				</svg>
				{/* The rungs' names around the arc, the knob's lit; the slider's value text already says the one in use. */}
				{ladder.map((rung, index) => {
					const [x, y] = dialPoint(angleOf(index), DIAL.labelR);
					return (
						<span key={rung.level} className={`effort-dial-label${index === activeIndex ? " is-current" : ""}`} aria-hidden="true" style={{ left: `${(100 * x) / DIAL.width}%`, top: `${(100 * y) / DIAL.height}%` }}>
							{effortDisplayName(rung.label)}
						</span>
					);
				})}
			</div>
		</div>
	);
}
