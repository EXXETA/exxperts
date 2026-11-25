import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from "react";
import { BackArrowIcon } from "./icons";
import { useSettingsLookNext } from "../settings-look";

/** The new look's way back from a page inside a page: the arrow alone, named for a screen reader by its aria-label. */
export const PaneBack = forwardRef<HTMLButtonElement, ButtonHTMLAttributes<HTMLButtonElement> & { "aria-label": string }>(function PaneBack({ className, ...button }, ref) {
	return <button type="button" ref={ref} className={`rs-btn rs-btn-icon rs-btn-sm pane-head-back${className ? ` ${className}` : ""}`} {...button}><BackArrowIcon size={16} /></button>;
});

/**
 * How every pane of Room settings and Settings opens: the title, one muted
 * line, and the pane's own actions on the right of the same row.
 *
 * In the new look (settings-look.ts) the line leaves the header and follows
 * it, so the title line alone stays put while the page scrolls; on a phone
 * the line comes first and the window's bar names the page. Only the new look
 * draws `back` (a `PaneBack`), `tile` (before the title), `beside` (quiet
 * words after it) and `tip` (the whole of a title that may be cut): the old
 * one has its own places for them.
 */
export function PaneHeader({ title, line, actions, back, tile, beside, tip }: { title: ReactNode; line?: ReactNode; actions?: ReactNode; back?: ReactNode; tile?: ReactNode; beside?: ReactNode; tip?: string }) {
	const lookNext = useSettingsLookNext();
	if (lookNext) {
		return (
			<div className="pane-top">
				<header className="pane-head">
					{back}
					{tile}
					<div className="pane-head-text">
						<h2 title={tip}>{title}</h2>
						{beside && <span className="pane-head-beside">{beside}</span>}
					</div>
					{actions && <div className="pane-head-actions">{actions}</div>}
				</header>
				{line && <p className="pane-lead">{line}</p>}
			</div>
		);
	}
	return (
		<header className="pane-head">
			<div className="pane-head-text">
				<h2>{title}</h2>
				{line && <p>{line}</p>}
			</div>
			{actions && <div className="pane-head-actions">{actions}</div>}
		</header>
	);
}

/** A group inside a pane: its kicker, an optional line, and its actions. */
export function GroupHeader({ kicker, line, actions }: { kicker: string; line?: ReactNode; actions?: ReactNode }) {
	return (
		<div className="group-head">
			<div className="pane-head-text">
				<p className="settings-group-kicker">{kicker}</p>
				{line && <p className="group-head-line">{line}</p>}
			</div>
			{actions && <div className="pane-head-actions">{actions}</div>}
		</div>
	);
}
