import { useId, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { flushSync } from "react-dom";
import { useEscapeKey } from "./use-escape-key";
import { BackArrowIcon, CloseIcon } from "./icons";
import { SettingsLookContext, settingsLookOn } from "../settings-look";

const PHONE_QUERY = "(max-width: 760px)";
/** Past two lines of help (18 each) and their gaps: a row this tall beside its control holds the control on its title's line. */
const TALL_ROW_WORDS = 42;

/** Said under a needed field its form found empty. */
const NEEDED_FIELD_LINE = "Fill this in.";

/**
 * A settings form's check in the new look: its main button is never greyed
 * for an empty field. Pressed with a needed field empty, it marks each empty
 * one with the field's red edge and a line under it, and moves to the first;
 * a mark goes as its field is filled.
 */
export function useNeededFields() {
	const [pressed, setPressed] = useState(false);
	const formId = useId();
	return {
		/**
		 * One field's mark: `props` go on the field and `line` right under it. `key` tells the form's fields apart;
		 * `describedBy` is the id of another line that describes the field.
		 */
		field(key: string, value: string, describedBy?: string) {
			const marked = pressed && !value.trim();
			const lineId = `${formId}-${key}`;
			return {
				props: {
					"aria-invalid": marked || undefined,
					"aria-describedby": [marked && lineId, describedBy].filter(Boolean).join(" ") || undefined,
				},
				// Hidden from the label it can stand in, so it is read once, as the field's description, and never as part of its name.
				line: marked && <span id={lineId} className="settings-needed-line" aria-hidden="true">{NEEDED_FIELD_LINE}</span>,
			};
		},
		/** True when every field holds something; otherwise marks the empty ones and focuses the first. */
		filled(fields: ReadonlyArray<readonly [value: string, field: HTMLElement | null]>): boolean {
			const empty = fields.find(([value]) => !value.trim());
			if (!empty) return true;
			// The marks are drawn before the focus moves, so a screen reader that follows the focus to the first field reads it with its line.
			flushSync(() => setPressed(true));
			empty[1]?.focus();
			return false;
		},
	};
}

export type SettingsDialogNavItem<Id extends string> = {
	id: Id;
	label: string;
	title?: string;
	danger?: boolean;
};

/**
 * The one shell both settings surfaces use (Room settings and Settings): a
 * header with an optional kicker, the title and one close control, then a
 * navigation column beside the pane. The dialog keeps one size on every pane
 * and sits centred; the pane scrolls inside, so switching panes moves nothing.
 *
 * On a phone the dialog is a full sheet that shows either the list of panes
 * or one pane with a way back to the list; Escape goes back to the list
 * first and closes from there.
 *
 * With the new look's switch on (settings-look.ts) the window's name heads
 * the navigation column, the kicker is no longer drawn but still starts the
 * window's spoken name, the close sits on the page's title line (on a phone,
 * one bar holds back, the page's name and close), and the pane marks when it
 * has scrolled, so the page header's hairline shows only then.
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
	const [lookNext] = useState(settingsLookOn);
	const kickerId = useId();
	const paneRef = useRef<HTMLDivElement>(null);
	const [scrolled, setScrolled] = useState(false);
	// Room settings keeps every page mounted in this one scroller, so the
	// hairline is read again whenever the page or the list changes.
	useLayoutEffect(() => {
		if (lookNext) setScrolled((paneRef.current?.scrollTop ?? 0) > 0);
	}, [lookNext, active, showList]);
	// A row's control sits in the row's middle; a row whose words below its
	// title run past two lines is marked data-tall, and its control sits on the
	// title's line instead (44-settings-look.css). Measured, since the words
	// wrap differently at each window width; read again as rows come and go.
	useLayoutEffect(() => {
		const pane = paneRef.current;
		if (!lookNext || !pane) return;
		const sizes = new ResizeObserver((entries) => {
			for (const { target: main } of entries) {
				const row = main.parentElement;
				if (!row || !main.getClientRects().length) continue;
				const words = main.getBoundingClientRect().height - (main.querySelector(".settings-row-label")?.getBoundingClientRect().height ?? 0);
				row.toggleAttribute("data-tall", words > TALL_ROW_WORDS);
			}
		});
		const watch = () => pane.querySelectorAll(".settings-row > .settings-row-main").forEach((main) => sizes.observe(main));
		watch();
		const added = new MutationObserver(watch);
		added.observe(pane, { childList: true, subtree: true });
		return () => {
			sizes.disconnect();
			added.disconnect();
		};
	}, [lookNext]);
	if (lookNext) {
		const activeLabel = nav.find((item) => item.id === active)?.label;
		return (
			<SettingsLookContext.Provider value={true}>
				<div className="settings-dialog-backdrop" onClick={onClose}>
					<div
						className={`settings-dialog ${className} settings-look-next${showList ? " show-list" : ""}${scrolled ? " is-scrolled" : ""}`}
						role="dialog"
						aria-modal="true"
						aria-label={label}
						aria-labelledby={labelledBy && kicker ? `${kickerId} ${labelledBy}` : labelledBy}
						onClick={(e) => e.stopPropagation()}
					>
						{kicker && <span id={kickerId} hidden>{kicker}</span>}
						<div className="settings-dialog-bar">
							<button type="button" className="settings-dialog-back" aria-label="All settings" onClick={() => setShowList(true)}><BackArrowIcon size={16} /></button>
							<h2 className="settings-dialog-bar-title">{activeLabel}</h2>
							<button type="button" className="rs-btn rs-btn-icon rs-btn-sm settings-dialog-close" onClick={onClose} aria-label="Close"><CloseIcon size={16} /></button>
						</div>
						<div className="settings-dialog-body">
							<div className="settings-dialog-side">
								<header className="settings-dialog-head">
									<div className="settings-dialog-heading">
										{title}
										{headNote}
									</div>
								</header>
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
							</div>
							<div className="settings-dialog-pane" ref={paneRef} onScroll={(e) => setScrolled(e.currentTarget.scrollTop > 0)}>
								{children}
							</div>
						</div>
					</div>
				</div>
			</SettingsLookContext.Provider>
		);
	}
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
					<button type="button" className="rs-btn rs-btn-icon settings-dialog-close" onClick={onClose} aria-label="Close"><CloseIcon size={16} /></button>
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
