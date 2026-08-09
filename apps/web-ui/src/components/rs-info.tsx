import { useEffect, useId, useState } from "react";

// Room settings info mark: hover, click or keyboard focus opens a real tooltip
// bubble with the text; Escape or leaving closes it. The trigger is a button so
// it is natively focusable, and clicks are prevented from bubbling so a mark
// inside a <label> row never flips the row's switch.
export function RsInfo({ text }: { text: string }) {
	const [open, setOpen] = useState(false);
	const tipId = useId();
	useEffect(() => {
		// A hover-opened tooltip has no focused button to catch Escape, so an
		// open tooltip listens at the document (capture, so it wins the race
		// against the settings modal's own Escape handler and the modal stays
		// open while only the tooltip closes).
		if (!open) return;
		const onEscape = (e: KeyboardEvent) => {
			if (e.key !== "Escape") return;
			e.stopPropagation();
			setOpen(false);
		};
		document.addEventListener("keydown", onEscape, true);
		return () => document.removeEventListener("keydown", onEscape, true);
	}, [open]);
	return (
		<span
			className="rs-info-anchor"
			onMouseEnter={() => setOpen(true)}
			onMouseLeave={() => setOpen(false)}
		>
			<button
				type="button"
				className="rs-info"
				aria-label="More information"
				aria-expanded={open}
				aria-describedby={open ? tipId : undefined}
				// Toggle, not open: on touch the button never focuses, so blur
				// would never close an always-open tooltip.
				onClick={(e) => { e.preventDefault(); setOpen((v) => !v); }}
				onFocus={() => setOpen(true)}
				onBlur={() => setOpen(false)}
			>
				i
			</button>
			{open && (
				<span
					className="rs-info-tip"
					role="tooltip"
					id={tipId}
					// Defensive: the bubble can sit inside a <label> row. Today the
					// label's control resolves to the info BUTTON (first labelable
					// descendant), so a bubble click cannot flip the row's switch;
					// consuming the click keeps that true if the row's structure or
					// label association ever changes.
					onClick={(e) => { e.preventDefault(); e.stopPropagation(); setOpen(false); }}
				>
					{text}
				</span>
			)}
		</span>
	);
}
