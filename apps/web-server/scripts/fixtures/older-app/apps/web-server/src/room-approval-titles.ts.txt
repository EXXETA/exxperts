/**
 * The questions a room asks the person before it acts, read back by the away
 * note and by the card's resolved line. No imports: the page reads this file.
 */

/** The command approval card's title. */
export const PERSISTENT_ROOM_COMMAND_APPROVAL_TITLE = "Run this command?";

/** What an old hand-off question asked a specialist to create ("an SVG chart"); null for any other question. */
export function handOffApprovalSubject(title: string): string | null {
	return /^Have a specialist create (.+)\?$/.exec(title)?.[1] ?? null;
}

/** Specialists are switched off: what an old hand-off card, or a change request from a page opened before, says now. */
export const SPECIALISTS_OFF_SENTENCE = "Specialists are switched off, so nothing was started.";
