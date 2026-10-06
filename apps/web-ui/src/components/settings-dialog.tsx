import { useState, type ReactNode } from "react";
import { useEscapeKey } from "./use-escape-key";

const PHONE_QUERY = "(max-width: 760px)";

export type SettingsDialogNavItem<Id extends string> = { id: Id; label: string; title?: string; danger?: boolean };

/**
 * The one shell both settings surfaces use (Room settings and Settings): a
 * header with an optional kicker, the title and one close control, then a
 * navigation column beside the pane. The dialog keeps one size on every pane
 * and sits centred; the pane scrolls inside, so switching panes moves nothing.
 *
 * On a phone the dialog is a full sheet that shows either the list of panes
 * or one pane with a way back to the list; Escape goes back to the list
 * first and closes from there.
 */
export function SettingsDialog<Id extends string>({
	className,
	label,
	labelledBy,
	kicker,
	title,
	headNote,
	navLabel,
	nav,
	active,
	onSelect,
	onClose,
	children,
	initialShowList = false,
}: {
	/** The surface's own class, which scopes that surface's pane rules. */
	className: string;
	label?: string;
	labelledBy?: string;
	kicker?: string;
	title: ReactNode;
	/** Lines under the title (a rename error, the rename preview). */
	headNote?: ReactNode;
	navLabel: string;
	nav: SettingsDialogNavItem<Id>[];
	active: Id;
	onSelect: (id: Id) => void;
	onClose: () => void;
	children: ReactNode;
	/** Phone only: open on the list of panes instead of the active pane. */
	initialShowList?: boolean;
}) {
	// Phone-sized screens only (CSS shows either the list or the pane); on
	// desktop both are visible and this flag has no effect.
	const [showList, setShowList] = useState(initialShowList);
	// A pane chosen from outside the nav (a failed save sends the dialog to
	// the pane that holds the draft) is shown on a phone too.
	const [shownActive, setShownActive] = useState(active);
	if (active !== shownActive) {
		setShownActive(active);
		setShowList(false);
	}
	useEscapeKey(() => {
		if (!showList && typeof window.matchMedia === "function" && window.matchMedia(PHONE_QUERY).matches) setShowList(true);
		else onClose();
	});
	return (
		<div className="settings-dialog-backdrop" onClick={onClose}>
			<div
				className={`settings-dialog ${className}${showList ? " show-list" : ""}`}
				role="dialog"
				aria-modal="true"
				aria-label={label}
				aria-labelledby={labelledBy}
				onClick={(e) => e.stopPropagation()}
			>
				<header className="settings-dialog-head">
					<div className="settings-dialog-heading">
						{kicker && <p className="settings-dialog-kicker">{kicker}</p>}
						{title}
						{headNote}
					</div>
					<button type="button" className="settings-dialog-close" onClick={onClose} aria-label="Close">×</button>
				</header>
				<div className="settings-dialog-body">
					<nav className="settings-dialog-nav" aria-label={navLabel}>
						{nav.map((item) => (
							<button
								key={item.id}
								type="button"
								data-section={item.id}
								title={item.title}
								className={`settings-dialog-nav-item${item.danger ? " danger" : ""}${item.id === active ? " active" : ""}`}
								aria-current={item.id === active ? "page" : undefined}
								onClick={() => {
									onSelect(item.id);
									setShowList(false);
								}}
							>
								{item.label}
							</button>
						))}
					</nav>
					<div className="settings-dialog-pane">
						<button type="button" className="settings-dialog-back" onClick={() => setShowList(true)}>← All settings</button>
						{children}
					</div>
				</div>
			</div>
		</div>
	);
}
