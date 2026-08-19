import { useState, type ReactNode } from "react";
import { useEscapeKey } from "./use-escape-key";

export type SettingsSection = "ai-setup" | "web-search" | "connectors" | "skills" | "remote";

export type SettingsOverlaySectionDef = { id: SettingsSection; label: string; title?: string; content: ReactNode };

/**
 * The one Settings surface. A centered modal over whatever the user was
 * doing: the machine-level configuration pages live here behind a left nav,
 * and closing returns to the exact prior view because the dimmed view
 * underneath never changes. The pages themselves render unchanged; this
 * component only owns the frame, the nav, and the phone-sized collapse
 * (the modal becomes a full-screen sheet, nav becomes a section list, a
 * section shows with a back affordance).
 */
export function SettingsOverlay({ sections, active, onSelect, onClose, initialMobileNav = false }: { sections: SettingsOverlaySectionDef[]; active: SettingsSection; onSelect: (section: SettingsSection) => void; onClose: () => void; initialMobileNav?: boolean }) {
	// Phone-sized screens only (CSS hides the other pane); on desktop both
	// panes stay visible and this flag has no effect.
	const [mobileNav, setMobileNav] = useState(initialMobileNav);
	useEscapeKey(onClose);
	const activeSection = sections.find((section) => section.id === active) ?? sections[0];
	return (
		<div className="settings-overlay-backdrop" onClick={onClose}>
			<div className={`settings-overlay${mobileNav ? " show-nav" : ""}`} role="dialog" aria-modal="true" aria-label="Settings" onClick={(e) => e.stopPropagation()}>
				{/* The one close control: a small X pinned to the modal's
				    top-right corner on every screen size, resting on the content
				    pane's non-scrolling top strip below. The nav names the tab,
				    so the pane carries no header bar with a title. */}
				<button type="button" className="settings-overlay-close" onClick={onClose} aria-label="Close settings">✕</button>
				<aside className="settings-overlay-nav">
					<div className="settings-overlay-nav-head">
						<h1>Settings.</h1>
					</div>
					<nav className="settings-overlay-sections" aria-label="Settings sections">
						{sections.map((section) => (
							<button
								key={section.id}
								type="button"
								data-section={section.id}
								title={section.title}
								className={`list-btn ${section.id === activeSection?.id ? "active" : ""}`}
								aria-current={section.id === activeSection?.id ? "page" : undefined}
								onClick={() => {
									onSelect(section.id);
									setMobileNav(false);
								}}
							>
								{section.label}
							</button>
						))}
					</nav>
				</aside>
				<div className="settings-overlay-content">
					{/* The pane's non-scrolling top strip: chromeless on desktop
					    (the X band; the scroll region starts below it), the back
					    bar on the phone sheet. The X above closes on every screen
					    size. */}
					<div className="settings-overlay-content-bar">
						<button type="button" className="icon-btn settings-overlay-back" onClick={() => setMobileNav(true)}>← Settings</button>
					</div>
					{activeSection?.content}
				</div>
			</div>
		</div>
	);
}
