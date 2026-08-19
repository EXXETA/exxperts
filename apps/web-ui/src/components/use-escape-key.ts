import { useEffect, useRef } from "react";

/**
 * Close a transient surface (dialog, overlay) when Escape is pressed.
 *
 * Layers stack: a gateway modal opens over the settings overlay, the upload
 * dialog over the skills tab. One Escape must close only the TOPMOST layer,
 * not the whole pile at once, so every mounted hook registers on a shared
 * stack and a single document listener fires only the newest entry. Mount
 * order is the stacking order: the layer mounted last is the one on top.
 */
type EscapeEntry = { fire: () => void };
const escapeStack: EscapeEntry[] = [];
let listenerAttached = false;

function onDocumentKeyDown(event: KeyboardEvent) {
	if (event.key !== "Escape") return;
	const top = escapeStack[escapeStack.length - 1];
	if (top) top.fire();
}

export function useEscapeKey(onEscape: () => void, enabled = true): void {
	const handlerRef = useRef(onEscape);
	handlerRef.current = onEscape;
	useEffect(() => {
		if (!enabled) return;
		const entry: EscapeEntry = { fire: () => handlerRef.current() };
		escapeStack.push(entry);
		if (!listenerAttached) {
			document.addEventListener("keydown", onDocumentKeyDown);
			listenerAttached = true;
		}
		return () => {
			const index = escapeStack.indexOf(entry);
			if (index !== -1) escapeStack.splice(index, 1);
			if (escapeStack.length === 0 && listenerAttached) {
				document.removeEventListener("keydown", onDocumentKeyDown);
				listenerAttached = false;
			}
		};
	}, [enabled]);
}
