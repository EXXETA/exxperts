// Where the keys that answer a waiting question reach it, for the page's own
// key listener and for the question rows' key hints. Enter and Esc answer a
// question only while the message box is empty; with text in the box, a
// question that was open before the person started typing is declined by
// their message (`messageDeclinesQuestion`); Enter also only while the
// focus is on the page or in the box, since a focused button or link takes
// Enter itself and a text field keeps it. The box writes whether it is
// empty; the rows read it without re-rendering the room on each letter.
import { useSyncExternalStore } from "react";

let empty = true;
// When the box last went from empty to holding text.
let draftStartedAt: number | null = null;
let pageFocus = true;
const listeners = new Set<() => void>();

function notify(): void {
	for (const listener of listeners) listener();
}

export function setComposerEmpty(value: boolean): void {
	if (empty === value) return;
	empty = value;
	draftStartedAt = value ? null : Date.now();
	notify();
}

/** When the person started typing the box's text; null while it is empty. */
export function currentDraftStartedAt(): number | null {
	return draftStartedAt;
}

/**
 * Whether sending the box's text declines a question that opened at
 * `openedAt`: only when the question was already open when the text was
 * started, so a question that opens under the person's typing never changes
 * what their Enter does.
 */
export function messageDeclinesQuestion(openedAt: number | undefined, startedAt: number | null): boolean {
	return openedAt !== undefined && startedAt !== null && openedAt <= startedAt;
}

/** A field that types, the message box included. */
export function isTextField(el: Element | null): boolean {
	return el instanceof HTMLElement && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.tagName === "SELECT" || el.isContentEditable);
}

/** Whether Enter pressed with the focus here may answer the question: the page itself, a quiet part of it, or the message box. */
export function enterReachesQuestion(el: Element | null): boolean {
	if (!el || el === document.body || el === document.documentElement) return true;
	if (el.closest(".composer-box") && el.tagName === "TEXTAREA") return true;
	if (isTextField(el)) return false;
	return !el.closest('button, a[href], summary, [role="button"], [role="link"], [role="menuitem"], [role="tab"], [role="checkbox"], [role="switch"], [role="option"]');
}

function readFocus(): void {
	const next = enterReachesQuestion(document.activeElement);
	if (pageFocus === next) return;
	pageFocus = next;
	notify();
}

function subscribe(listener: () => void): () => void {
	if (listeners.size === 0) {
		document.addEventListener("focusin", readFocus);
		document.addEventListener("focusout", readFocus);
	}
	listeners.add(listener);
	readFocus();
	return () => {
		listeners.delete(listener);
		if (listeners.size === 0) {
			document.removeEventListener("focusin", readFocus);
			document.removeEventListener("focusout", readFocus);
		}
	};
}

export function useDraftStartedAt(): number | null {
	return useSyncExternalStore(subscribe, () => draftStartedAt, () => draftStartedAt);
}

export function useComposerEmpty(): boolean {
	return useSyncExternalStore(subscribe, () => empty, () => empty);
}

/** Whether Enter, pressed now, would reach the question: the box is empty and the focus lets it through. */
export function useEnterReachesQuestion(): boolean {
	return useSyncExternalStore(subscribe, () => empty && pageFocus, () => empty && pageFocus);
}
