import { useEffect, useRef, useState, type MouseEvent, type ReactNode } from "react";

// A browser's own title tooltip stays away after a click, which is usually the active tab or the
// opened file, so the tabs and the file tree draw their own.
const TOOLTIP_DELAY_MS = 400;

export function useHoverTooltip(): { show: (event: MouseEvent<HTMLElement>, text: string) => void; hide: () => void; tooltip: ReactNode } {
	const [state, setState] = useState<{ text: string; left: number; top: number } | null>(null);
	const timer = useRef<number | undefined>(undefined);
	useEffect(() => () => window.clearTimeout(timer.current), []);
	const hide = () => { window.clearTimeout(timer.current); setState(null); };
	const show = (event: MouseEvent<HTMLElement>, text: string) => {
		const box = event.currentTarget.getBoundingClientRect();
		window.clearTimeout(timer.current);
		timer.current = window.setTimeout(() => setState({ text, left: box.left, top: box.bottom + 4 }), TOOLTIP_DELAY_MS);
	};
	const tooltip = state && <div className="workspace-tab-tooltip" role="tooltip" style={{ left: state.left, top: state.top }}>{state.text}</div>;
	return { show, hide, tooltip };
}
