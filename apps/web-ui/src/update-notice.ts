import { useEffect, useState } from "react";

/**
 * Update notice, page side. The desktop shell checks for a newer release once
 * at startup and writes the result into this page (a property for a page that
 * renders after the push, an event for one already on screen); there is no
 * IPC to ask over. In a browser tab nothing ever writes it and the hook stays
 * empty, which is the honest answer there: a browser cannot install anything.
 *
 * The shell's string is treated as untrusted anyway and must look like a
 * version number before it reaches the menu, so no global set by anything
 * else can put text in front of the user.
 */
export type UpdateSnapshot = { available: string | null; current: string };

const DISMISSED_KEY = "exxperts.updateDismissed";
const UPDATE_EVENT = "exxperts:update";

function cleanVersion(value: unknown): string | null {
	return typeof value === "string" && /^\d+\.\d+\.\d+$/.test(value) ? value : null;
}

function readPushedVersion(): string | null {
	const pushed = (window as unknown as { __exxpertsUpdate?: UpdateSnapshot }).__exxpertsUpdate;
	return cleanVersion(pushed?.available);
}

function readDismissed(): string | null {
	try {
		return localStorage.getItem(DISMISSED_KEY);
	} catch {
		return null;
	}
}

export type UpdateNotice = {
	/** The version on offer, or null when there is nothing to offer. */
	available: string | null;
	/** The gear dot: hidden once this exact version has been dismissed. */
	dotVisible: boolean;
	/** Dismiss the dot for this version only; the next release brings it back. */
	dismiss: () => void;
};

export function useUpdateNotice(): UpdateNotice {
	const [available, setAvailable] = useState<string | null>(readPushedVersion);
	const [dismissed, setDismissed] = useState<string | null>(readDismissed);

	useEffect(() => {
		function onUpdate(event: Event) {
			const detail = (event as CustomEvent<UpdateSnapshot>).detail;
			setAvailable(cleanVersion(detail?.available));
		}
		window.addEventListener(UPDATE_EVENT, onUpdate);
		// A push that landed between the first render and this effect would
		// otherwise be missed entirely.
		setAvailable(readPushedVersion());
		return () => window.removeEventListener(UPDATE_EVENT, onUpdate);
	}, []);

	return {
		available,
		dotVisible: available !== null && dismissed !== available,
		dismiss: () => {
			if (!available) return;
			try {
				localStorage.setItem(DISMISSED_KEY, available);
			} catch {
				// A blocked store only costs the dot's memory; never break the menu.
			}
			setDismissed(available);
		},
	};
}

/**
 * The page's one channel for asking the shell to run the real update flow
 * (same navigation-interception trick the focus and task-done links use).
 */
export function requestUpdate(): void {
	window.location.href = "exxperts://update";
}
