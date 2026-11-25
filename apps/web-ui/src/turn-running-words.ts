// What a person reads while a room's last answer has not ended, whether it is
// still being written or still stopping. The server refuses with a code (a
// message, opening or leaving the room) or a reason (archive and delete); its
// own error text names ids and is for the logs, so no screen shows it.

/** A message sent meanwhile, put back in the box. A passing note: it goes once the turn is over and is never saved. */
export const TURN_RUNNING_LINE = "The last answer is still finishing; send your message in a moment.";

/** The note in older words: builds from before the note was kept out of saves wrote it into threads, and it goes on the way in too. */
const OLDER_TURN_RUNNING_LINE = "The last answer is still finishing. Your message is back in the box; send it in a moment.";

export function isTurnRunningNote(item: { kind: string; text?: unknown }): boolean {
	return item.kind === "system" && (item.text === TURN_RUNNING_LINE || item.text === OLDER_TURN_RUNNING_LINE);
}

/** Inside the room, anything else refused meanwhile. */
export const ROOM_TURN_RUNNING_LINE = "The last answer in this room is still finishing. Try again when it's done.";

/** Home, after leaving or opening the room meanwhile: Home shows many rooms, so the line names this one, and the way on is back in. */
export function homeTurnRunningLine(roomName: string): string {
	return `The last answer in ${roomName || "this room"} is still finishing. Open the room again when it's done.`;
}

/** Archiving or deleting it meanwhile: the line says which of the two was refused. The room's own pane leaves the name out. */
export function removalTurnRunningLine(removal: RoomRemoval, roomName = "This room"): string {
	return `${roomName} wasn't ${removal}: its last answer is still finishing. Try again when it's done.`;
}

export type RoomRemoval = "archived" | "deleted";

/** The server's code for a running turn (persistent-agent-store.ts), and archive's and delete's reason for one (persistent-agent-archive.ts). */
const TURN_RUNNING_REFUSALS: ReadonlySet<unknown> = new Set(["turn_running", "turn_in_flight"]);

export function isTurnRunningRefusal(codeOrReason: unknown): boolean {
	return TURN_RUNNING_REFUSALS.has(codeOrReason);
}
