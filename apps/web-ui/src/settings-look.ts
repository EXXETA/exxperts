import { createContext, useContext } from "react";

/**
 * The switch for the settings windows' look. The new look is on unless this
 * browser's local storage key names the old one: set it to "classic" to turn
 * back (`localStorage.setItem("exxperts.settingsLook", "classic")`, then reopen
 * the window). On when the key is missing, holds any other value or storage
 * cannot be read. No control sets it. The shell reads it once when a window
 * opens and hands it down through the context below, so one window never mixes
 * the two looks.
 */
export const SETTINGS_LOOK_KEY = "exxperts.settingsLook";
export const SETTINGS_LOOK_OLD = "classic";

export function settingsLookOn(): boolean {
	try {
		return window.localStorage.getItem(SETTINGS_LOOK_KEY) !== SETTINGS_LOOK_OLD;
	} catch {
		return true;
	}
}

/** True inside a settings window that shows the new look; false anywhere else. */
export const SettingsLookContext = createContext(false);

export function useSettingsLookNext(): boolean {
	return useContext(SettingsLookContext);
}
