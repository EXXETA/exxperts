// The way on that ends the line of a scheduled run a shared server paused
// because the room's answers went unopened: opening the room lets a repeating
// task run again at its next time. The server writes it on the run; the page
// (apps/web-ui/src/scheduled-run-reason.ts) leaves it off a one-time task's
// run, since a one-time task whose run was paused never runs again. The run
// keeps only its sentence, not why it paused, so both sides share this one.
export const OPEN_ROOM_TO_RESTART = "Open this room to start it again.";

/** A paused run's sentence as a one-time task shows it: without the way on only a repeating task has. */
export function withoutRestartSentence(message: string): string {
	return message.endsWith(` ${OPEN_ROOM_TO_RESTART}`) ? message.slice(0, -OPEN_ROOM_TO_RESTART.length - 1) : message;
}
