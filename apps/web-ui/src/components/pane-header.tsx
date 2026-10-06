import type { ReactNode } from "react";

/**
 * How every pane of Room settings and Settings opens: the title, one muted
 * line, and the pane's own actions on the right of the same row.
 */
export function PaneHeader({ title, line, actions }: { title: string; line?: ReactNode; actions?: ReactNode }) {
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
