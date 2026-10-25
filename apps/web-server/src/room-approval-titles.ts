/**
 * The questions a room asks the person before it acts, read back by the away
 * note and by the card's resolved line. No imports: the page reads this file.
 */

/** The command approval card's title. */
export const PERSISTENT_ROOM_COMMAND_APPROVAL_TITLE = "Run this command?";

/** The hand-off's question, for "an SVG chart" or "a slide deck". */
export function handOffApprovalTitle(subject: string): string {
	return `Have a specialist create ${subject}?`;
}

/** What a hand-off question asks a specialist to create; null for any other question. */
export function handOffApprovalSubject(title: string): string | null {
	return /^Have a specialist create (.+)\?$/.exec(title)?.[1] ?? null;
}
