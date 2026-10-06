import { useEffect, useRef } from "react";

/** How a pane hands its save to the dialog that asks before closing over its draft. */
export type RegisterSave = (save: () => Promise<boolean>) => void;

/**
 * Registers a pane's save once, as a stable function that always runs the
 * pane's current save. The unsaved question's Save and close calls it; the
 * save resolves false when it cannot save or fails, with the pane's own error.
 */
export function useRegisteredSave(register: RegisterSave | undefined, save: () => Promise<boolean>): void {
	const saveRef = useRef(save);
	saveRef.current = save;
	useEffect(() => {
		register?.(() => saveRef.current());
	}, [register]);
}
