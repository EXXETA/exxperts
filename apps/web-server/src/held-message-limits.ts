// How much a conversation's queued and held messages may hold: the page
// checks it before it queues a message (one over it stays in the box), and
// the server before it keeps one on disk (held-messages-store.ts), so a page
// that sends more than this cannot fill the disk or stall the server reading
// and rewriting the file.

/** Characters in one queued message: about 25,000 words, past any follow-up a person types or pastes; a longer text goes as a file. */
export const MAX_QUEUED_MESSAGE_CHARS = 100_000;
/** Messages held for one conversation: as many as one answer holds waiting (room-socket.ts MAX_WAITING_STEERS), and a few answers more. */
export const MAX_HELD_MESSAGES = 50;
/** Characters held for one conversation: one answer's twenty waiting messages at full size; reading or rewriting that file takes milliseconds. */
export const MAX_HELD_CHARS = 2_000_000;

/** Whether a message of this length fits beside the ones queued or held already, by count and by size. */
export function fitsHeldLimits(held: readonly { text: string }[], text: string): boolean {
	if (text.length > MAX_QUEUED_MESSAGE_CHARS || held.length >= MAX_HELD_MESSAGES) return false;
	return held.reduce((sum, message) => sum + message.text.length, 0) + text.length <= MAX_HELD_CHARS;
}
