import { type ReactNode } from "react";
import { SettingsDialog } from "./settings-dialog";

export type SettingsSection = "ai-setup" | "web-search" | "instructions" | "connectors" | "skills" | "remote" | "profile";

export type SettingsOverlaySectionDef = { id: SettingsSection; label: string; title?: string; content: ReactNode };

/**
 * The one Settings surface: the machine-level configuration pages behind a
 * navigation column, in the same dialog shell as Room settings. Closing
 * returns to the exact prior view because the dimmed view underneath never
 * changes.
 */
export function SettingsOverlay({ sections, active, onSelect, onClose, initialMobileNav = false }: { sections: SettingsOverlaySectionDef[]; active: SettingsSection; onSelect: (section: SettingsSection) => void; onClose: () => void; initialMobileNav?: boolean }) {
	const activeSection = sections.find((section) => section.id === active) ?? sections[0];
	return (
		<SettingsDialog
			className="settings-overlay"
			label="Settings"
			title={<h1 className="settings-dialog-title">Settings.</h1>}
			navLabel="Settings sections"
			nav={sections.map(({ id, label, title }) => ({ id, label, title }))}
			active={activeSection.id}
			onSelect={onSelect}
			onClose={onClose}
			initialShowList={initialMobileNav}
		>
			{activeSection.content}
		</SettingsDialog>
	);
}
