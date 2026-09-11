/**
 * The talk key: hold it to talk, release it to send, press it while the room
 * answers to cut the answer off. Stored as text the way the settings file
 * keeps it, "Alt+Space" or "Ctrl+Shift+KeyV": modifiers in a fixed order,
 * then the key's code. At least one modifier, so a plain letter can never be
 * taken away from typing. Pure functions; the smoke runs them in Node.
 */

export type TalkKey = { ctrl: boolean; alt: boolean; shift: boolean; meta: boolean; code: string };

export const DEFAULT_TALK_KEY = "Alt+Space";

const CODE = /^[A-Za-z0-9]{1,20}$/;
const MODIFIER_KEYS = new Set(["Control", "Alt", "Shift", "Meta"]);

export function parseTalkKey(text: string): TalkKey | null {
	const parts = text.split("+").filter(Boolean);
	const code = parts.pop() ?? "";
	if (!CODE.test(code) || parts.length === 0) return null;
	const key: TalkKey = { ctrl: false, alt: false, shift: false, meta: false, code };
	for (const part of parts) {
		if (part === "Ctrl") key.ctrl = true;
		else if (part === "Alt") key.alt = true;
		else if (part === "Shift") key.shift = true;
		else if (part === "Meta") key.meta = true;
		else return null;
	}
	return key;
}

export function serializeTalkKey(key: TalkKey): string {
	return [key.ctrl && "Ctrl", key.alt && "Alt", key.shift && "Shift", key.meta && "Meta", key.code].filter(Boolean).join("+");
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
	const names = mac ? { ctrl: "⌃", alt: "⌥", shift: "⇧", meta: "⌘" } : { ctrl: "Ctrl", alt: "Alt", shift: "Shift", meta: "Win" };
	const parts = [key.ctrl && names.ctrl, key.alt && names.alt, key.shift && names.shift, key.meta && names.meta, codeLabel(key.code)].filter(Boolean) as string[];
	return parts.join(mac ? " " : "+");
}

type KeyDownLike = Pick<KeyboardEvent, "code" | "ctrlKey" | "altKey" | "shiftKey" | "metaKey">;
type KeyUpLike = Pick<KeyboardEvent, "code" | "key">;

/** Is this key-down the talk key? Exactly its modifiers, no more and no fewer. */
export function isTalkKeyDown(event: KeyDownLike, key: TalkKey): boolean {
	return event.code === key.code && event.ctrlKey === key.ctrl && event.altKey === key.alt && event.shiftKey === key.shift && event.metaKey === key.meta;
}

/** Does this key-up end the hold? The key itself, or any modifier the combination needs. */
export function releasesTalkKey(event: KeyUpLike, key: TalkKey): boolean {
	if (event.code === key.code) return true;
	return (key.ctrl && event.key === "Control") || (key.alt && event.key === "Alt") || (key.shift && event.key === "Shift") || (key.meta && event.key === "Meta");
}

/** A combination from a key press while a new talk key is being recorded; null while it would not be a valid one yet. */
export function talkKeyFromEvent(event: KeyDownLike & Pick<KeyboardEvent, "key">): string | null {
	if (MODIFIER_KEYS.has(event.key)) return null;
	if (!(event.ctrlKey || event.altKey || event.shiftKey || event.metaKey)) return null;
	if (!CODE.test(event.code)) return null;
	return serializeTalkKey({ ctrl: event.ctrlKey, alt: event.altKey, shift: event.shiftKey, meta: event.metaKey, code: event.code });
}
