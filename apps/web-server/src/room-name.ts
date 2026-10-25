/**
 * A name as people see it, in one place. Browser-safe on purpose (no node
 * imports): the server keeps every name a person types trimmed with
 * trimHumanText, and the page trims, orders and shows room names with these
 * same functions.
 */

// Zero-width, direction and filler characters show as nothing, so a name of
// only those would be a blank card and title.
const INVISIBLE_EDGES = /^[\s\p{Cc}\u00AD\u061C\u115F\u1160\u180E\u200B-\u200F\u202A-\u202E\u2060-\u2064\u2066-\u206F\u3164\uFFA0]+|[\s\p{Cc}\u00AD\u061C\u115F\u1160\u180E\u200B-\u200F\u202A-\u202E\u2060-\u2064\u2066-\u206F\u3164\uFFA0]+$/gu;

/** One space between words, nothing invisible at either end. */
export function trimHumanText(value: string): string {
	return value.replace(/\s+/g, " ").replace(INVISIBLE_EDGES, "");
}

/** The name a person can see. A room named before invisible names were refused reads "Unnamed room", so it can be found and renamed. */
export function shownRoomName(name: string | null | undefined): string {
	if (!name) return "";
	return trimHumanText(name) || "Unnamed room";
}
