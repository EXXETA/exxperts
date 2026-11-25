import { type ComponentType, type ReactNode } from "react";
import { SettingsDialog } from "./settings-dialog";

/** A section an edition adds before the page starts (addSettingsSection); the shared page adds none. */
export type AddedSettingsSection = `added-${string}`;

export type SettingsSection = "ai-setup" | "instructions" | "skills" | "connectors" | "web-search" | "appearance" | "remote" | "profile" | AddedSettingsSection;

export type SettingsOverlaySectionDef = { id: SettingsSection; label: string; title?: string; content: ReactNode };

type AddedSectionDef = { id: AddedSettingsSection; label: string; title?: string; shows: () => boolean; Content: ComponentType };

const addedSections: AddedSectionDef[] = [];

/** Adds a section after the page's own, shown at each render while shows() says so. */
export function addSettingsSection(section: AddedSectionDef): void {
	addedSections.push(section);
}

/**
 * The one Settings surface: the machine-level configuration pages behind a
 * navigation column, in the same dialog shell as Room settings. Closing
 * returns to the exact prior view because the dimmed view underneath never
 * changes.
 */
export function SettingsOverlay({ sections, active, onSelect, onClose, initialMobileNav = false }: { sections: SettingsOverlaySectionDef[]; active: SettingsSection; onSelect: (section: SettingsSection) => void; onClose: () => void; initialMobileNav?: boolean }) {
	const shown = [...sections, ...addedSections.filter((section) => section.shows()).map(({ id, label, title, Content }) => ({ id, label, title, content: <Content /> }))];
	const activeSection = shown.find((section) => section.id === active) ?? shown[0];
	return (
		<SettingsDialog
			className="settings-overlay"
			label="Settings"
			title={<h1 className="settings-dialog-title">Settings.</h1>}
			navLabel="Settings sections"
			nav={shown}
			active={activeSection.id}
			onSelect={onSelect}
			onClose={onClose}
			initialShowList={initialMobileNav}
		>
			{activeSection.content}
		</SettingsDialog>
	);
}
