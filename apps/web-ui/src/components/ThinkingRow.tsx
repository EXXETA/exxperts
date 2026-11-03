import { useEffect, useRef, useState, type ReactNode, type RefObject } from "react";
import { thoughtForText, thoughtTime, useOpenThought, useThoughtWords, type ThoughtGroup } from "../thinking-text-store";
import { runningForText } from "./Message";
import { ThoughtWords } from "./thought-words";

// Line icons on a 16 px grid, drawn in the text colour: emoji draw differently on each system. The work card draws its rows with them too.
const ICONS = {
	file: <><path d="M4 2.5h5l3 3v8H4z" /><path d="M9 2.5v3h3" /></>,
	folder: <path d="M2 4.5h4l1.5 1.5H14v7H2z" />,
	term: <><rect x="2" y="3" width="12" height="10" rx="1.5" /><path d="M5 7l2 1.5L5 10M8.5 10.5H11" /></>,
	search: <><circle cx="7" cy="7" r="4" /><path d="M10 10l3.5 3.5" /></>,
	globe: <><circle cx="8" cy="8" r="5.5" /><path d="M2.5 8h11M8 2.5c2 2 2 9 0 11M8 2.5c-2 2-2 9 0 11" /></>,
	pen: <path d="M3 13l.6-2.6 6.9-6.9 2 2-6.9 6.9z" />,
	spark: <path d="M8 2.5v3M8 10.5v3M2.5 8h3M10.5 8h3M4.4 4.4l1.6 1.6M10 10l1.6 1.6M4.4 11.6L6 10M10 6l1.6-1.6" />,
	check: <path d="M3.5 8.5l3 3 6-7" />,
	ban: <><circle cx="8" cy="8" r="5.5" /><path d="M4.2 11.8l7.6-7.6" /></>,
	chev: <path d="M6 4l4 4-4 4" />,
	x: <path d="M4.5 4.5l7 7M11.5 4.5l-7 7" />,
	stop: <rect x="4.5" y="4.5" width="7" height="7" rx="1" />,
	plug: <><path d="M6 2.5v3M10 2.5v3M4.5 5.5h7v2.5a3.5 3.5 0 0 1-7 0z" /><path d="M8 11.5v2" /></>,
	book: <><path d="M3 3.5h4a1 1 0 0 1 1 1v9a1 1 0 0 0-1-1H3zM13 3.5H9a1 1 0 0 0-1 1v9a1 1 0 0 1 1-1h4z" /></>,
	handoff: <><circle cx="6" cy="5.5" r="2" /><path d="M2.5 13c.4-2.2 1.8-3.5 3.5-3.5s3.1 1.3 3.5 3.5M10.5 6.5h3M12 5l1.5 1.5L12 8" /></>,
	tool: <path d="M10.5 2.8a3 3 0 0 0-3.4 4L3 10.9 5.1 13l4.1-4.1a3 3 0 0 0 4-3.4l-1.8 1.8-1.7-.4-.4-1.7z" />,
	away: <path d="M6 3.5H3.5v9h9V10M9 3.5h3.5V7M12.5 3.5 7.5 8.5" />,
};
export type WorkIconName = keyof typeof ICONS;

export function WorkIcon({ name, className = "" }: { name: WorkIconName; className?: string }) {
	return <svg className={`wk-ic ${className}`} viewBox="0 0 16 16" aria-hidden="true">{ICONS[name]}</svg>;
}

/** Keeps a live element's motion still while it is scrolled out of view. */
export function useOffscreen<T extends HTMLElement>(): RefObject<T> {
	const ref = useRef<T>(null);
	useEffect(() => {
		const node = ref.current;
		if (!node || typeof IntersectionObserver !== "function") return;
		const observer = new IntersectionObserver(([entry]) => {
			if (entry.isIntersecting) node.removeAttribute("data-offscreen");
			else node.setAttribute("data-offscreen", "");
		});
		observer.observe(node);
		return () => observer.disconnect();
	}, []);
	return ref;
}

/** Re-renders every second while `on`, for a live timer. */
export function useNow(on: boolean): number {
	const [now, setNow] = useState(() => Date.now());
	useEffect(() => {
		if (!on) return;
		setNow(Date.now());
		const timer = setInterval(() => setNow(Date.now()), 1000);
		return () => clearInterval(timer);
	}, [on]);
	return now;
}

/** A label whose words rise into place when they change; `children`, when given, draws those words (a command in code). */
export function Label({ text, className = "", children }: { text: string; className?: string; children?: ReactNode }) {
	return <span key={text} className={`wk-lbl ${className}`}>{children ?? text}</span>;
}

/**
 * Thinking with no steps beside it: one line, a breathing dot, "Thinking"
 * with the sweep and its timer, and nothing under it. Done, it reads
 * "Thought for 7 s". Either way a click opens the whole thought; while it
 * thinks it grows there, kept at its newest line. A block with no words, or
 * a redacted one, is the label alone. Thoughts with nothing shown between
 * them are one line (`ThoughtGroup`).
 */
export function ThinkingRow({ group }: { group: ThoughtGroup }) {
	const words = useThoughtWords(group);
	const { live, ms, since } = thoughtTime(group);
	const now = useNow(live);
	const { open, toggle, ref: fullRef, onScroll } = useOpenThought<HTMLDivElement>(group[0].id, words, live);
	const ref = useOffscreen<HTMLDivElement>();
	const label = live ? "Thinking" : thoughtForText(ms, words.length > 0);
	const canOpen = words.length > 0;
	const head = (
		<>
			<span className="wk-lead">{live ? <span className="wk-dot" /> : <WorkIcon name="spark" />}</span>
			<span className="wk-label"><Label text={label} className={live ? "wk-sweep" : ""} /></span>
			{live && <span className="wk-time">{runningForText(ms + now - since!)}</span>}
			{canOpen && <WorkIcon name="chev" className="wk-caret" />}
		</>
	);
	return (
		<div className="bubble-row">
			{/* Open, the growing thought is read by choice, not announced word by word. */}
			<div className="wk-thought" data-live={live ? "1" : "0"} data-open={open ? "1" : "0"} ref={ref} role={live && !open ? "status" : undefined}>
				{canOpen ? (
					<button type="button" className="wk-head" aria-expanded={open} onClick={toggle}>{head}</button>
				) : (
					<div className="wk-head">{head}</div>
				)}
				{open && <div className="wk-full" ref={fullRef} onScroll={onScroll}><ThoughtWords thoughts={words} /></div>}
			</div>
		</div>
	);
}

/** Thinking as a row of a work card: "Thinking" while it runs, "Thought for 7 s" after, either opening to the whole thought (ThinkingRow's rules). */
export function ThinkingCardRow({ group }: { group: ThoughtGroup }) {
	const words = useThoughtWords(group);
	const { live, ms } = thoughtTime(group);
	const { open, toggle, ref, onScroll } = useOpenThought<HTMLDivElement>(group[0].id, words, live);
	const canOpen = words.length > 0;
	const label = live ? "Thinking" : thoughtForText(ms, words.length > 0);
	return (
		<>
			<div className="wk-row" data-s={live ? "running" : "done"}>
				<span className="wk-row-ic"><WorkIcon name="spark" /></span>
				{canOpen ? (
					// The sweep draws its words with a background, which the button's own rules clear: it lives on the words.
					<button type="button" className="wk-tx wk-open" aria-expanded={open} onClick={toggle}><span className={live ? "wk-sweep" : undefined}>{label}</span><WorkIcon name="chev" className="wk-caret" /></button>
				) : (
					<span className={`wk-tx${live ? " wk-sweep" : ""}`}>{label}</span>
				)}
				<span className="wk-meta" />
				<span className="wk-mk" />
			</div>
			{open && <div className="wk-out wk-out-thought" ref={ref} onScroll={onScroll}><ThoughtWords thoughts={words} /></div>}
		</>
	);
}
