/**
 * The talk key: hold it to talk, release it to send, press it while the room
 * answers to cut the answer off. Stored as text the way the settings file
 * keeps it, "Alt+Space", "Ctrl+Alt" or "Fn+Shift": modifiers in a fixed
 * order, then the key's code if there is one. A key needs at least one
 * modifier so a plain letter can never be taken away from typing; modifiers
 * on their own need at least two, so a lone Shift stays a Shift. Fn counts as
 * a modifier where the browser reports it. Pure functions; the smoke runs
 * them in Node.
 */

export type Modifiers = { ctrl: boolean; alt: boolean; shift: boolean; meta: boolean; fn: boolean };
/** An empty code means the combination is modifiers only. */
export type TalkKey = Modifiers & { code: string };

export const DEFAULT_TALK_KEY = "Alt+Space";
export const NO_MODIFIERS: Modifiers = { ctrl: false, alt: false, shift: false, meta: false, fn: false };

const CODE = /^[A-Za-z0-9]{1,20}$/;
const MODIFIER_EVENT_KEYS = new Set(["Control", "Alt", "Shift", "Meta", "Fn"]);

function modifierCount(mods: Modifiers): number {
	return [mods.ctrl, mods.alt, mods.shift, mods.meta, mods.fn].filter(Boolean).length;
}

export function parseTalkKey(text: string): TalkKey | null {
	const parts = text.split("+");
	if (parts.some((part) => !part)) return null;
	const key: TalkKey = { ...NO_MODIFIERS, code: "" };
	for (const [index, part] of parts.entries()) {
		if (part === "Ctrl") key.ctrl = true;
		else if (part === "Alt") key.alt = true;
		else if (part === "Shift") key.shift = true;
		else if (part === "Meta") key.meta = true;
		else if (part === "Fn") key.fn = true;
		else if (index === parts.length - 1 && CODE.test(part)) key.code = part;
		else return null;
	}
	const mods = modifierCount(key);
	if (key.code ? mods < 1 : mods < 2) return null;
	return key;
}

export function serializeTalkKey(key: TalkKey): string {
	// Fn first, where it sits on a Mac keyboard.
	return [key.fn && "Fn", key.ctrl && "Ctrl", key.alt && "Alt", key.shift && "Shift", key.meta && "Meta", key.code].filter(Boolean).join("+");
}

function codeLabel(code: string): string {
	if (/^Key[A-Z]$/.test(code)) return code.slice(3);
	if (/^Digit[0-9]$/.test(code)) return code.slice(5);
	return code;
}

/** What the bar and the settings show: symbols on a Mac, words elsewhere. */
export function formatTalkKey(text: string, mac: boolean): string {
	const key = parseTalkKey(text);
	if (!key) return text;
	return formatModifiers(key, mac, key.code ? codeLabel(key.code) : "");
}

export function formatModifiers(mods: Modifiers, mac: boolean, tail = ""): string {
	const names = mac ? { ctrl: "⌃", alt: "⌥", shift: "⇧", meta: "⌘", fn: "fn" } : { ctrl: "Ctrl", alt: "Alt", shift: "Shift", meta: "Win", fn: "Fn" };
	const parts = [mods.fn && names.fn, mods.ctrl && names.ctrl, mods.alt && names.alt, mods.shift && names.shift, mods.meta && names.meta, tail].filter(Boolean) as string[];
	return parts.join(mac ? " " : "+");
}

type KeyEventLike = Pick<KeyboardEvent, "code" | "key" | "ctrlKey" | "altKey" | "shiftKey" | "metaKey">;

/** Is this event a modifier going down or up, rather than a key? */
export function isModifierEvent(event: Pick<KeyboardEvent, "code" | "key">): boolean {
	return MODIFIER_EVENT_KEYS.has(event.key) || event.code === "Fn";
}

/** The modifiers held at this event. Fn has no flag on the event, so the caller tracks it. */
export function modifiersOf(event: KeyEventLike, fnDown = false): Modifiers {
	return { ctrl: event.ctrlKey, alt: event.altKey, shift: event.shiftKey, meta: event.metaKey, fn: fnDown || event.code === "Fn" || event.key === "Fn" };
}

export function unionModifiers(a: Modifiers, b: Modifiers): Modifiers {
	return { ctrl: a.ctrl || b.ctrl, alt: a.alt || b.alt, shift: a.shift || b.shift, meta: a.meta || b.meta, fn: a.fn || b.fn };
}

function sameModifiers(a: Modifiers, b: Modifiers): boolean {
	return a.ctrl === b.ctrl && a.alt === b.alt && a.shift === b.shift && a.meta === b.meta && a.fn === b.fn;
}

/**
 * Is this key-down the talk key? Exactly its modifiers, no more and no fewer.
 * A modifiers-only combination completes on the key-down of its last
 * modifier, and only on a modifier's key-down, so a letter typed while the
 * modifiers are held does not start a second hold.
 */
export function isTalkKeyDown(event: KeyEventLike, key: TalkKey, fnDown = false): boolean {
	const mods = modifiersOf(event, fnDown);
	if (key.code) return event.code === key.code && sameModifiers(mods, key);
	return isModifierEvent(event) && sameModifiers(mods, key);
}

/** Does this key-up end the hold? The key itself, or any modifier the combination needs. */
export function releasesTalkKey(event: Pick<KeyboardEvent, "code" | "key">, key: TalkKey): boolean {
	if (key.code && event.code === key.code) return true;
	return (key.ctrl && event.key === "Control") || (key.alt && event.key === "Alt") || (key.shift && event.key === "Shift") || (key.meta && event.key === "Meta") || (key.fn && (event.key === "Fn" || event.code === "Fn"));
}

/** While recording: a key pressed with at least one modifier becomes the talk key at once. */
export function talkKeyFromEvent(event: KeyEventLike, fnDown = false): string | null {
	if (isModifierEvent(event)) return null;
	const mods = modifiersOf(event, fnDown);
	if (modifierCount(mods) < 1 || !CODE.test(event.code)) return null;
	return serializeTalkKey({ ...mods, code: event.code });
}

/** While recording: modifiers released without a key become the talk key if there were at least two of them. */
export function modifiersOnlyTalkKey(mods: Modifiers): string | null {
	return modifierCount(mods) >= 2 ? serializeTalkKey({ ...mods, code: "" }) : null;
}
